/**
 * Mailbox warmup as the tenant sees it, and the daily per-workspace pass that
 * moves mailboxes along (`provisioning` -> `warming` -> `active`, ramping the
 * daily cap, and pausing mailboxes whose WeldHost domain lapsed).
 *
 * The warming itself is WeldSuite's own warmup network
 * (apps/workers/reach-warmup-worker): every WeldReach mailbox is a row in the
 * master pool (`reach_warmup_mailboxes`), sends and answers generated mail, and
 * measures where it landed. reach-api registers a mailbox in the pool, keeps it
 * in step with the tenant row (see services/mailboxes.ts) and reads the pool
 * back here. A mailbox may join campaigns once `warmupGate` says so: 14 days of
 * warmup, 85% inbox placement over 3 days and no login errors
 * (docs/plans/weldreach-warmup.md).
 *
 * `processWorkspaceWarmup` is called from `cron/warmup-sweep.ts` for one
 * workspace at a time (due-index kind `reach_warmup`) and returns when the
 * workspace next needs a visit. The pool is read from master once per visit.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { omitSensitive } from '@weldsuite/db/lib/sensitive-columns';
import type { ReachMailServerCredentials } from '@weldsuite/db/schema';
import { schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { WELDREACH_SENDING_DEFAULTS, type ReachWarmupBlocker } from '@weldsuite/app-api-client/schemas/reach';
import { WARMUP_MIN_POOL_DOMAINS, warmupGate } from '@weldsuite/reach-domain/warmup';
import {
  pausePoolMailbox,
  readPoolMailboxes,
  registerPoolMailbox,
  resumePoolMailbox,
  type PoolMailboxView,
  type WarmupKeyEnv,
} from '@weldsuite/reach-domain/warmup-pool';
import { openMailServerCredentials, sealMailServerCredentials } from '../lib/credentials';
import { imapCredentialsOf, smtpCredentialsOf } from '../lib/mailpool';
import type { MailpoolClient } from '../lib/mailpool/client';
import type { MailpoolMailbox } from '../lib/mailpool/types';
import { utcDayStart, utcTomorrow } from './access';
import { getOrCreateReachSettings } from './settings';

type MailboxRow = typeof schema.reachMailboxes.$inferSelect;
type MailboxPatch = Partial<typeof schema.reachMailboxes.$inferInsert>;
type DomainRow = typeof schema.reachDomains.$inferSelect;
type HostDomainRow = typeof schema.hostDomains.$inferSelect;

/** The pool's `paused_reason` / the tenant's `pausedReason` for each way a mailbox leaves the warmup. */
export const POOL_PAUSE_REASONS = {
  user: 'paused_by_user',
  suspended: 'mailbox_suspended',
  domainInactive: 'domain_inactive',
  domainError: 'domain_error',
} as const;
const LOGIN_FAILED = 'login_failed';
const LOW_INBOX_RATE = 'low_inbox_rate';

/** Shown to the customer when the network cannot sign in to a mailbox (the raw provider error stays in master). */
const LOGIN_FAILED_MESSAGE =
  'The warmup network could not sign in to this mailbox. Check the mailbox login at your provider.';

// ---------------------------------------------------------------------------
// What the pool says
// ---------------------------------------------------------------------------

/**
 * A login failed and has not been cleared. The warmup worker clears
 * `lastLoginError` (and its timestamp) when a login works again, so a set error
 * is a current one.
 */
export function hasLoginError(pool: Pick<PoolMailboxView, 'lastLoginError'>): boolean {
  return pool.lastLoginError !== null && pool.lastLoginError !== '';
}

/** Where a paused mailbox goes on resume: straight to `active` only if it still passes the health gate. */
export function resumeStatusFor(mailbox: Pick<MailboxRow, 'warmupDay' | 'warmupInboxRate'>): 'active' | 'warming' {
  const gate = warmupGate({ rampDay: mailbox.warmupDay, inboxRate3d: mailbox.warmupInboxRate, hasLoginError: false });
  return gate.ready ? 'active' : 'warming';
}

/**
 * Why a warming mailbox may not join campaigns yet; null when it may (or is not
 * warming). `poolDomains` is the number of domains in the pool (null when
 * unknown): below WARMUP_MIN_POOL_DOMAINS the planner has nobody to pair with.
 */
export function warmupBlockerOf(
  mailbox: Pick<MailboxRow, 'status' | 'warmupDay' | 'warmupInboxRate'>,
  pool: PoolMailboxView | undefined,
  poolDomains: number | null,
): ReachWarmupBlocker | null {
  if (mailbox.status !== 'warming') return null;
  const gate = warmupGate({
    rampDay: pool ? pool.rampDay : mailbox.warmupDay,
    inboxRate3d: pool ? (pool.stats?.inboxRate3d ?? null) : mailbox.warmupInboxRate,
    hasLoginError: pool ? hasLoginError(pool) : false,
  });
  if (gate.ready) return null;
  // A login problem needs the customer; a small pool is the more useful news for everything else.
  if (gate.reason !== 'login_error' && poolDomains !== null && poolDomains < WARMUP_MIN_POOL_DOMAINS) return 'pool_too_small';
  return gate.reason;
}

/** The pool's verdict that takes a warming or active mailbox out of use, if any. */
function poolFailureOf(pool: PoolMailboxView): typeof LOGIN_FAILED | typeof LOW_INBOX_RATE | null {
  if (pool.status === 'error' && pool.pausedReason === LOGIN_FAILED) return LOGIN_FAILED;
  if (pool.status === 'paused' && pool.pausedReason === LOW_INBOX_RATE) return LOW_INBOX_RATE;
  return null;
}

/** Inbox rates are stored with four decimals (numeric(5,4)). */
function roundRate(rate: number | null | undefined): number | null {
  return typeof rate === 'number' ? Math.round(rate * 10_000) / 10_000 : null;
}

/** The tenant columns that mirror the pool, only where they differ. */
function poolSyncPatch(mailbox: MailboxRow, pool: PoolMailboxView): MailboxPatch {
  const patch: MailboxPatch = {};
  const rate = roundRate(pool.stats?.inboxRate3d);
  if (mailbox.warmupDay !== pool.rampDay) patch.warmupDay = pool.rampDay;
  if (mailbox.warmupStatus !== pool.status) patch.warmupStatus = pool.status;
  if (mailbox.warmupInboxRate !== rate) patch.warmupInboxRate = rate;
  return patch;
}

// ---------------------------------------------------------------------------
// Registering a mailbox in the pool
// ---------------------------------------------------------------------------

export interface PoolRegistrationDeps {
  db: Database;
  master: MasterDatabase;
  env: WarmupKeyEnv;
  /** Clerk org id (the tenant key). */
  clerkOrgId: string;
  /** Master `workspaces.id`. */
  masterWorkspaceId: string;
}

export interface MailboxLogins {
  smtp: ReachMailServerCredentials;
  imap: ReachMailServerCredentials;
}

/**
 * Add a mailbox to the warmup pool (status `waiting`; the warmup worker starts
 * it once the pool spans enough domains). `timezone` is the workspace's default
 * (`reach_settings.defaultTimezone`), read here when the caller has not.
 * Throws when WELDREACH_WARMUP_KEY is missing.
 */
export async function registerMailboxInPool(
  deps: PoolRegistrationDeps,
  mailbox: Pick<MailboxRow, 'id' | 'email' | 'firstName' | 'lastName' | 'type'>,
  logins: MailboxLogins,
  timezone?: string,
): Promise<void> {
  await registerPoolMailbox(deps.master, deps.env, {
    workspaceId: deps.masterWorkspaceId,
    clerkOrgId: deps.clerkOrgId,
    tenantMailboxId: mailbox.id,
    email: mailbox.email,
    firstName: mailbox.firstName,
    lastName: mailbox.lastName,
    mailboxType: mailbox.type,
    timezone: timezone ?? (await getOrCreateReachSettings(deps.db)).defaultTimezone,
    smtp: logins.smtp,
    imap: logins.imap,
  });
}

// ---------------------------------------------------------------------------
// The per-workspace pass
// ---------------------------------------------------------------------------

export interface WarmupEvent {
  entityId: string;
  data: Record<string, unknown>;
  /** `suspended` when the mailbox needs attention (the platform and workflows hear it as a suspension); default `updated`. */
  action?: 'updated' | 'suspended';
}

export interface WarmupPublisher {
  (event: WarmupEvent): Promise<void> | void;
}

export interface WorkspaceWarmupDeps {
  db: Database;
  master: MasterDatabase;
  /** Null when MAILPOOL_API_KEY is not set: mailboxes still being provisioned then wait. */
  mailpool: MailpoolClient | null;
  env: WarmupKeyEnv & { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string };
  clerkOrgId: string;
  /** Master `workspaces.id`. */
  masterWorkspaceId: string;
  now: Date;
  /** Publishes `reach_mailbox:updated` (or `suspended`) for a mailbox whose status changed. */
  publish?: WarmupPublisher;
}

/**
 * The mailbox states this pass looks at. `error` is here for the ones the
 * warmup network put there (`login_failed`): they come back when the login works.
 */
const LIVE_STATUSES = ['provisioning', 'warming', 'active', 'paused', 'error'] as const;

/** A WeldHost domain that is no longer usable for sending: gone, not active, or past its expiry. */
function hostLapsed(host: HostDomainRow | undefined, now: Date): boolean {
  if (!host || host.deletedAt) return true;
  if (host.status !== 'active') return true;
  return !!host.expiresAt && host.expiresAt.getTime() <= now.getTime();
}

interface PassContext {
  domainById: Map<string, DomainRow>;
  hostById: Map<string, HostDomainRow>;
  /** This workspace's pool rows by tenant mailbox id. */
  pool: Map<string, PoolMailboxView>;
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
  // One master read per workspace; a failure fails the visit, which the sweep retries later.
  const pool = await readPoolMailboxes(deps.master, deps.clerkOrgId);
  const ctx: PassContext = {
    domainById: new Map(domains.map((d) => [d.id, d])),
    hostById: new Map(hosts.map((h) => [h.id, h])),
    pool: new Map(pool.map((p) => [p.tenantMailboxId, p])),
  };

  const final: MailboxRow[] = [];
  for (const mailbox of mailboxes) {
    try {
      final.push(await advanceMailbox(deps, ctx, mailbox));
    } catch (err) {
      // One mailbox's trouble (Mailpool 5xx, a master hiccup) must not stop the rest.
      console.error(`[reach-warmup] mailbox ${mailbox.id} failed:`, err);
      final.push(mailbox);
    }
  }

  return nextVisit(final, ctx, now);
}

async function advanceMailbox(deps: WorkspaceWarmupDeps, ctx: PassContext, mailbox: MailboxRow): Promise<MailboxRow> {
  const { now } = deps;
  const domain = ctx.domainById.get(mailbox.domainId);
  const lapsed = domain ? hostLapsed(ctx.hostById.get(domain.hostDomainId), now) : false;
  const pool = ctx.pool.get(mailbox.id);

  // Mailpool's own errors are cleared by its webhook; only the warmup network's login failure is ours.
  if (mailbox.status === 'error') return advanceLoginError(deps, mailbox, pool);

  // WeldHost domain expired or not renewed: stop using its mailboxes, in the pool too.
  if (lapsed && mailbox.status !== 'paused') {
    await pausePoolMailbox(deps.master, deps.clerkOrgId, mailbox.id, POOL_PAUSE_REASONS.domainInactive);
    return save(deps, mailbox, { status: 'paused', pausedReason: 'domain_inactive' });
  }
  if (mailbox.status === 'paused') return advancePaused(deps, mailbox, pool, lapsed || domain?.status !== 'active');

  switch (mailbox.status) {
    case 'provisioning':
      return advanceProvisioning(deps, mailbox);
    case 'warming':
    case 'active':
      return advanceFromPool(deps, mailbox, pool);
    default:
      return mailbox;
  }
}

/** Persist a change and tell the platform. Nothing to write is nothing done. */
async function save(
  deps: Pick<WorkspaceWarmupDeps, 'db' | 'now' | 'publish'>,
  mailbox: MailboxRow,
  patch: MailboxPatch,
  action: WarmupEvent['action'] = 'updated',
): Promise<MailboxRow> {
  if (Object.keys(patch).length === 0) return mailbox;
  const [updated] = await deps.db
    .update(schema.reachMailboxes)
    .set({ ...patch, updatedAt: deps.now })
    .where(eq(schema.reachMailboxes.id, mailbox.id))
    .returning();
  const row = updated ?? mailbox;
  const statusChanged = row.status !== mailbox.status;
  if (statusChanged && deps.publish) {
    try {
      await deps.publish({ entityId: row.id, data: omitSensitive('reach_mailboxes', row), action });
    } catch (err) {
      console.warn('[reach-warmup] entity event failed:', err);
    }
  }
  return row;
}

/** A paused mailbox the pass itself paused comes back on its own; a user's pause never does. */
async function advancePaused(
  deps: WorkspaceWarmupDeps,
  mailbox: MailboxRow,
  pool: PoolMailboxView | undefined,
  domainUnusable: boolean,
): Promise<MailboxRow> {
  if (domainUnusable) return mailbox;

  if (mailbox.pausedReason === 'domain_inactive') {
    await resumePoolMailbox(deps.master, deps.clerkOrgId, mailbox.id);
    return save(deps, mailbox, { status: resumeStatusFor(mailbox), pausedReason: null });
  }

  // Paused for placement: once the pool stops holding it, warm again and let the gate decide.
  if (mailbox.pausedReason === LOW_INBOX_RATE && pool && poolIsRunning(pool)) {
    const warming = await save(deps, mailbox, { status: 'warming', pausedReason: null });
    return advanceFromPool(deps, warming, pool);
  }
  return mailbox;
}

/** The network is warming or maintaining this mailbox (not held, not failing, not waiting for a pool). */
function poolIsRunning(pool: PoolMailboxView): boolean {
  return pool.status === 'warming' || pool.status === 'maintaining' || pool.status === 'waiting';
}

/** A mailbox the network could not log in to: back to warming once the login works again. */
async function advanceLoginError(
  deps: WorkspaceWarmupDeps,
  mailbox: MailboxRow,
  pool: PoolMailboxView | undefined,
): Promise<MailboxRow> {
  if (mailbox.pausedReason !== LOGIN_FAILED || !pool || pool.status === 'error' || hasLoginError(pool)) return mailbox;
  const warming = await save(deps, mailbox, { status: 'warming', pausedReason: null, lastError: null });
  return advanceFromPool(deps, warming, pool);
}

/**
 * Warming and active mailboxes follow the pool: copy its ramp day, status and
 * inbox rate, take a mailbox out of use when the pool does (login failure,
 * low placement), graduate a warming one through the health gate, and ramp an
 * active one's campaign cap.
 */
async function advanceFromPool(
  deps: WorkspaceWarmupDeps,
  mailbox: MailboxRow,
  pool: PoolMailboxView | undefined,
): Promise<MailboxRow> {
  if (!pool) {
    // Not in the pool (it should be): nothing to learn, so only the campaign ramp moves.
    console.warn(`[reach-warmup] mailbox ${mailbox.id} is not in the warmup pool`);
    return mailbox.status === 'active' ? save(deps, mailbox, rampPatch(mailbox, deps.now)) : mailbox;
  }

  const sync = poolSyncPatch(mailbox, pool);
  const failure = poolFailureOf(pool);
  if (failure === LOGIN_FAILED) {
    return save(deps, mailbox, { ...sync, status: 'error', pausedReason: LOGIN_FAILED, lastError: LOGIN_FAILED_MESSAGE }, 'suspended');
  }
  if (failure === LOW_INBOX_RATE) return save(deps, mailbox, { ...sync, status: 'paused', pausedReason: LOW_INBOX_RATE });

  if (mailbox.status === 'active') return save(deps, mailbox, { ...sync, ...rampPatch(mailbox, deps.now) });

  const gate = warmupGate({
    rampDay: pool.rampDay,
    inboxRate3d: pool.stats?.inboxRate3d ?? null,
    hasLoginError: hasLoginError(pool),
  });
  if (!gate.ready) return save(deps, mailbox, sync);
  return save(deps, mailbox, {
    ...sync,
    status: 'active',
    rampCurrent: Math.min(WELDREACH_SENDING_DEFAULTS.rampStart, mailbox.dailyCap),
    rampUpdatedAt: deps.now,
  });
}

/** A mailbox Mailpool was still creating: once it is active there, store its logins and start warming. */
async function advanceProvisioning(deps: WorkspaceWarmupDeps, mailbox: MailboxRow): Promise<MailboxRow> {
  if (!mailbox.mailpoolMailboxId || !deps.mailpool) return mailbox;
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

export interface BeginWarmingDeps extends PoolRegistrationDeps {
  env: PoolRegistrationDeps['env'] & { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string };
  now: Date;
  publish?: WarmupPublisher;
}

/**
 * A mailbox that is now active at Mailpool: store the logins it brings, register
 * it in the warmup pool and move it to `warming`. Shared by the sweep and the
 * Mailpool webhook. Without usable logins (in `remote` or already stored) the
 * mailbox stays `provisioning` and the next pass tries again; a pool failure
 * throws, leaving it `provisioning` too (registering again is idempotent).
 */
export async function beginWarming(deps: BeginWarmingDeps, mailbox: MailboxRow, remote: MailpoolMailbox | null): Promise<MailboxRow> {
  const smtp = (remote && smtpCredentialsOf(remote)) ?? (await openMailServerCredentials(deps.env, mailbox.smtpCredentials));
  const imap = (remote && imapCredentialsOf(remote)) ?? (await openMailServerCredentials(deps.env, mailbox.imapCredentials));
  if (!smtp || !imap) return mailbox;

  await registerMailboxInPool(deps, mailbox, { smtp, imap });

  const patch: MailboxPatch = {
    status: 'warming',
    warmupStartedAt: mailbox.warmupStartedAt ?? deps.now,
    warmupStatus: 'waiting',
    pausedReason: null,
    lastError: null,
  };
  if (!mailbox.smtpCredentials) patch.smtpCredentials = await sealMailServerCredentials(deps.env, smtp);
  if (!mailbox.imapCredentials) patch.imapCredentials = await sealMailServerCredentials(deps.env, imap);

  return save(deps, mailbox, patch);
}

/** The campaign ramp: active mailboxes grow their daily cap by `rampStep` once a day, up to `dailyCap`. */
function rampPatch(mailbox: MailboxRow, now: Date): MailboxPatch {
  const cap = mailbox.dailyCap;
  let ramp = mailbox.rampCurrent;

  if (ramp > cap) {
    ramp = cap;
  } else if (ramp < cap && (!mailbox.rampUpdatedAt || mailbox.rampUpdatedAt < utcDayStart(now))) {
    ramp = Math.min(cap, ramp + WELDREACH_SENDING_DEFAULTS.rampStep);
  }
  return ramp === mailbox.rampCurrent ? {} : { rampCurrent: ramp, rampUpdatedAt: now };
}

/**
 * When this workspace next needs a visit: tomorrow while a mailbox is still
 * warming, ramping, paused for placement or a failed login (both come back on
 * their own), or waiting for its domain to come back; otherwise the earliest
 * expiry of a domain in use, so a lapse is noticed without waking the tenant
 * every day. null when nothing needs watching.
 */
function nextVisit(mailboxes: MailboxRow[], ctx: Pick<PassContext, 'domainById' | 'hostById'>, now: Date): Date | null {
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
      (m.status === 'paused' && (m.pausedReason === 'domain_inactive' || m.pausedReason === LOW_INBOX_RATE)) ||
      (m.status === 'error' && m.pausedReason === LOGIN_FAILED);
    if (progressing) consider(tomorrow);

    if (m.status === 'active' || m.status === 'warming' || m.status === 'provisioning') {
      const domain = ctx.domainById.get(m.domainId);
      const expiresAt = domain ? ctx.hostById.get(domain.hostDomainId)?.expiresAt : null;
      if (expiresAt && expiresAt.getTime() > now.getTime()) consider(expiresAt);
    }
  }
  return next;
}
